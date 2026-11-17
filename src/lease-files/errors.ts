import type { ErrorDetailsMap, SimlockErrorCode } from "../contract/index.js";

/** why: a refusal the lease-files routes answer with its code, the message and the code's declared details on the wire. */
export class LeaseFilesError<Code extends SimlockErrorCode = SimlockErrorCode> extends Error {
  constructor(
    readonly code: Code,
    message: string,
    readonly details: ErrorDetailsMap[Code],
  ) {
    super(message);
    this.name = "LeaseFilesError";
  }
}
