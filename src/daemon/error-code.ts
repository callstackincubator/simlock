/**
 * The single place that turns a thrown core/daemon error into a `SimlockErrorCode`. ADR 0003
 * §7: "CLI exit codes and HTTP status codes are columns of the same error table, not second
 * mappings." Both transports -- `DaemonServer`'s socket frame handling (`errorCode` in
 * `server.ts`) and the HTTP gateway (`mapError` in `../http/errors.ts`) -- call `classifyError`
 * to get the *code*, then read whichever column they need (`cliExitCode`/`httpStatus`) off
 * `ERROR_TABLE` themselves. Before this module existed, each transport hand-wrote its own
 * `instanceof` chain for these errors and the two silently drifted (see the ADR 0003-09 review,
 * finding B5): `InsufficientDiskSpaceError`, `LicenseNotAcceptedError`, `StartupFailedError`,
 * `DoctorUnavailableError`, and `NukeUnavailableError` all mapped correctly over the socket but
 * fell through to `INTERNAL` over HTTP. Adding a new core error now means adding one branch
 * here, not one in each transport.
 *
 * `DispatchError`'s own `code` is used verbatim (trusted by construction -- see `dispatcher.ts`,
 * every call site passes a real `SimlockErrorCode`) rather than re-classified, since it is
 * already the shared dispatcher's own protocol-shaped rejection.
 *
 * Deliberately excludes anything that is socket-framing-specific (`ProtocolError`, thrown only
 * while parsing a request frame before a `Session` exists -- it never reaches the shared
 * dispatcher, so it never reaches HTTP either) -- that stays local to `server.ts`.
 */
import {
  InsufficientDiskSpaceError,
  LicenseNotAcceptedError,
  NoCapacityError,
  NoDriverError,
  QueueTimeoutError,
  RequesterAlreadyLeasedError,
  RuntimeMissingError,
  UnknownLeaseError,
  UnknownModelError,
} from "../core/index.js";
import type { SimlockErrorCode } from "../contract/index.js";
import { DispatchError, DoctorUnavailableError, NukeUnavailableError } from "./dispatcher.js";
import { AdminAuthenticationFailedError } from "./session.js";

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
  // `DispatchError` is `Dispatcher`'s own protocol-shaped rejection (bad input, role/authorize
  // failure, unknown operation, a rejected credential) -- its `code` is already a
  // `SimlockErrorCode` by construction (see `dispatcher.ts`), so it is used verbatim rather than
  // re-derived.
  if (error instanceof DispatchError) {
    return error.code as SimlockErrorCode;
  }
  if (error instanceof AdminAuthenticationFailedError) {
    return "ADMIN_AUTHENTICATION_FAILED";
  }
  if (error instanceof NoCapacityError) {
    return "NO_CAPACITY";
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
  if (error instanceof RuntimeMissingError) {
    return "RUNTIME_MISSING";
  }
  if (error instanceof UnknownModelError) {
    return "UNKNOWN_MODEL";
  }
  if (error instanceof InsufficientDiskSpaceError) {
    return "INSUFFICIENT_DISK_SPACE";
  }
  if (error instanceof LicenseNotAcceptedError) {
    return "LICENSE_NOT_ACCEPTED";
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
  return undefined;
}
