import { isSimlockError } from "../contract/index.js";
import { BaselineMismatchError, BaselineStaleError, UnknownBaselineError } from "../core/index.js";
import { LeaseIdTakenError } from "../leasing/index.js";
import { DispatchError } from "./dispatch.js";

/** why: the refusals of a `lease.request` that carry their own details on the wire, in one place so the dispatcher's catch stays short. */
export function leaseRequestRefusal(error: unknown): DispatchError | undefined {
  if (isSimlockError(error) && error.code === "LEASE_ENDED") {
    return new DispatchError(error.code, error.message, error.details);
  }
  if (error instanceof LeaseIdTakenError) {
    return new DispatchError("LEASE_ID_TAKEN", error.message, { leaseId: error.leaseId });
  }
  if (error instanceof UnknownBaselineError) {
    return new DispatchError("UNKNOWN_BASELINE", error.message, { name: error.baselineName });
  }
  if (error instanceof BaselineMismatchError) {
    return new DispatchError("BASELINE_MISMATCH", error.message, {
      baseline: error.baselineName,
      field: error.field,
    });
  }
  if (error instanceof BaselineStaleError) {
    return new DispatchError("BASELINE_STALE", error.message, {
      baseline: error.baselineName,
      reason: error.reason,
    });
  }
  return undefined;
}
