/**
 * why: both transports classify a thrown error here and read their own column off
 * `ERROR_TABLE`, so a core error maps the same over the socket and over HTTP; per-transport
 * `instanceof` chains drifted apart before. `ProtocolError` is left out: it is thrown only while
 * parsing a frame before a `Session` exists, so it never reaches HTTP.
 */
import {
  BaselineMismatchError,
  BaselineStaleError,
  ComponentBusyError,
  ComponentInstallerClosedError,
  ComponentInstallTimeoutError,
  ComponentNotOwnedError,
  InsufficientDiskSpaceError,
  BootTimeoutError,
  LicenseNotAcceptedError,
  NoDriverError,
  PassthroughRefusedError,
  RuntimeMissingError,
  UnknownBaselineError,
  UnknownLeaseError,
  UnknownModelError,
  UnknownPassthroughToolError,
  BadDeviceRequestError,
  UnsupportedRequestOptionError,
  type LeaseRequestFailure,
} from "../core/index.js";
import {
  DaemonUpdatingError,
  IdempotencyConflictError,
  LeaseIdTakenError,
  LeaseRequestForbiddenError,
  NoCapacityError,
  ProvisionFailedError,
  QueueTimeoutError,
  RequesterAlreadyLeasedError,
  ReplayedLeaseRequestError,
} from "../leasing/index.js";
import { ExecOutputDeliveryStalledError } from "../ports/index.js";
import { ERROR_TABLE, type SimlockErrorCode } from "../contract/index.js";
import { DispatchError, DoctorUnavailableError, NukeUnavailableError } from "./dispatcher.js";
import { AdminAuthenticationFailedError } from "../auth/index.js";

/**
 * Thrown to a request parked on startup readiness (ADR §2 step 4's `awaitReady`) when
 * convergence rejected. Lives here (not `server.ts`) so both transports can recognize it:
 * `DaemonServer#awaitReady` throws it directly into the shared dispatcher's `dispatch()`, which
 * neither socket nor HTTP request handling wraps -- so an HTTP route can catch this exact class
 * just as `errorCode` does for a socket response.
 */
export class StartupFailedError extends Error {
  constructor() {
    super("Daemon failed to start");
    this.name = "StartupFailedError";
  }
}

/**
 * Classifies a thrown error into the contract's closed `SimlockErrorCode` set. Every branch
 * here has a matching row in `ERROR_TABLE` (`src/contract/errors.ts`) by construction; a caller
 * that needs a transport-specific column (HTTP status, CLI exit code) looks the returned code
 * up in that table itself rather than this function guessing a transport's own representation.
 *
 * Returns `undefined` -- deliberately, rather than defaulting to `"INTERNAL"` itself -- for
 * anything unrecognized, so each transport decides its own `INTERNAL` handling (the socket
 * transport always echoes the real error message; the HTTP gateway deliberately does not, to
 * avoid leaking implementation detail into a response body -- see `mapError`). A caller that
 * doesn't care about that distinction can just do `classifyError(error) ?? "INTERNAL"`.
 */
// fallow-ignore-next-line complexity -- one exhaustive classifier is the point (ADR §7).
export function classifyError(error: unknown): SimlockErrorCode | undefined {
  // why: a `DispatchError` carries a `SimlockErrorCode` by construction, so its code is used
  // verbatim rather than re-derived.
  if (error instanceof DispatchError) {
    return error.code as SimlockErrorCode;
  }
  if (error instanceof AdminAuthenticationFailedError) {
    return "ADMIN_AUTHENTICATION_FAILED";
  }
  // why: a stored failure carries the code it was classified as when the request first failed, and it is
  // read back from `state.db`, so it is checked against the table rather than trusted.
  if (error instanceof ReplayedLeaseRequestError) {
    return isErrorCode(error.code) ? error.code : "INTERNAL";
  }
  if (error instanceof IdempotencyConflictError) {
    return "IDEMPOTENCY_CONFLICT";
  }
  if (error instanceof LeaseIdTakenError) {
    return "LEASE_ID_TAKEN";
  }
  if (error instanceof LeaseRequestForbiddenError) {
    return "FORBIDDEN";
  }
  // The gateway's own admission refusal (`FleetLeaseCoordinator#admit`) is a plain
  // `DispatchError("NO_CAPACITY", ...)`, not a distinct class -- caught by the `DispatchError`
  // branch above (H9, round 2 review). Before this it was its own class in
  // `src/gateway/fleet-coordinator.ts`, imported here so `src/daemon` -- every worker-mode
  // daemon, not just gateway mode -- pulled the whole gateway module graph into ordinary
  // startup just to recognize it.
  if (error instanceof NoCapacityError) {
    return "NO_CAPACITY";
  }
  if (error instanceof DaemonUpdatingError) {
    return "DAEMON_UPDATING";
  }
  // why: a device that did not boot is a provisioning failure; the lease's own rejection reason
  // (`boot-timeout`) is set by leasing, not here.
  if (error instanceof ProvisionFailedError || error instanceof BootTimeoutError) {
    return "PROVISION_FAILED";
  }
  if (error instanceof QueueTimeoutError) {
    return "QUEUE_TIMEOUT";
  }
  if (error instanceof RequesterAlreadyLeasedError) {
    return "REQUESTER_ALREADY_LEASED";
  }
  if (error instanceof NoDriverError) {
    return "NO_DRIVER";
  }
  if (error instanceof PassthroughRefusedError) {
    return "PASSTHROUGH_REFUSED";
  }
  if (error instanceof UnknownPassthroughToolError) {
    return "UNKNOWN_PASSTHROUGH_TOOL";
  }
  if (error instanceof RuntimeMissingError) {
    return "RUNTIME_MISSING";
  }
  if (error instanceof UnknownModelError) {
    return "UNKNOWN_MODEL";
  }
  if (error instanceof UnknownBaselineError) {
    return "UNKNOWN_BASELINE";
  }
  if (error instanceof BaselineMismatchError) {
    return "BASELINE_MISMATCH";
  }
  if (error instanceof BaselineStaleError) {
    return "BASELINE_STALE";
  }
  // A request option the platform's driver does not have: the request itself is wrong, and
  // asking again unchanged can never succeed.
  if (error instanceof UnsupportedRequestOptionError || error instanceof BadDeviceRequestError) {
    return "BAD_REQUEST";
  }
  if (error instanceof InsufficientDiskSpaceError) {
    return "INSUFFICIENT_DISK_SPACE";
  }
  if (error instanceof LicenseNotAcceptedError) {
    return "LICENSE_NOT_ACCEPTED";
  }
  if (error instanceof ComponentInstallTimeoutError) {
    return "DOWNLOAD_TIMEOUT";
  }
  // A component install still open when the daemon stopped (ADR 0010 §6): running it again,
  // against the restarted daemon, is the recovery.
  if (error instanceof ComponentInstallerClosedError) {
    return "DAEMON_STOPPING";
  }
  // ADR 0010 §8's refused removals. `COMPONENT_IN_USE` carries its counts as details, so the
  // dispatcher's `component.remove` handler raises it as a `DispatchError` (above).
  if (error instanceof ComponentNotOwnedError) {
    return "COMPONENT_NOT_OWNED";
  }
  if (error instanceof ComponentBusyError) {
    return "COMPONENT_BUSY";
  }
  if (error instanceof UnknownLeaseError) {
    return "UNKNOWN_LEASE";
  }
  if (error instanceof StartupFailedError) {
    return "DAEMON_STARTUP_FAILED";
  }
  if (error instanceof DoctorUnavailableError) {
    return "DOCTOR_UNAVAILABLE";
  }
  if (error instanceof NukeUnavailableError) {
    return "NUKE_UNAVAILABLE";
  }
  // `device.exec`'s timeout path (`Dispatcher#awaitExec`) swallows this one before it can
  // reach here -- once the kill is issued, `EXEC_TIMEOUT` is the authoritative answer, not a
  // race with this rejection. What lands here is the other case: a command that exited on its
  // own while a chunk's delivery to a stalled consumer was still outstanding. There is no more
  // specific code for "something may have been dropped" than `INTERNAL`, but the branch is
  // explicit rather than left to a transport's own `?? "INTERNAL"` default, so it reads as a
  // deliberate classification instead of an unrecognized error that happened to fall through.
  if (error instanceof ExecOutputDeliveryStalledError) {
    return "INTERNAL";
  }
  return undefined;
}

function isErrorCode(code: string): code is SimlockErrorCode {
  return Object.hasOwn(ERROR_TABLE, code);
}

/**
 * What a failed lease request stores: the code `classifyError` gives the failure, and its
 * message -- except for a failure nothing classifies, which stores `INTERNAL` with a generic
 * message. A stored message is replayed to every frontend, the HTTP one included, which never
 * shows an unclassified error's own text (see `mapError`), so it is never stored either.
 */
export function describeLeaseRequestFailure(error: unknown): LeaseRequestFailure {
  const code = classifyError(error);
  if (code === undefined || !(error instanceof Error)) {
    return { code: "INTERNAL", message: "Internal error" };
  }
  return { code, message: error.message };
}
