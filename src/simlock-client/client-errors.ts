import {
  type AnySimlockError,
  fromWireError,
  isSimlockError,
  SimlockError,
} from "../contract/index.js";
import { WireCallError } from "./wire.js";

export function cancelledError(): SimlockError<"CANCELLED"> {
  return new SimlockError("CANCELLED", "domain", "Lease request was cancelled", {});
}

export function toSimlockError(error: unknown): AnySimlockError {
  if (isSimlockError(error)) return error;
  if (error instanceof WireCallError)
    return fromWireError(error.code, error.message, error.details);
  return new SimlockError(
    "DAEMON_CONNECTION_LOST",
    "transport",
    error instanceof Error ? error.message : String(error),
    {},
  );
}
