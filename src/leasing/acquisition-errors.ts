import { noPhysicalMatch, type PhysicalRequest, UnknownModelError } from "../core/index.js";
import { type WaitingReason } from "./acquisition-planner.js";

export class NoCapacityError extends Error {
  constructor(readonly reason?: WaitingReason) {
    super("No device capacity is currently available");
    this.name = "NoCapacityError";
  }
}

export class ProvisionFailedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ProvisionFailedError";
  }
}

/** why: mapped to `DAEMON_UPDATING`; the message is what a refused agent reads. */
export class DaemonUpdatingError extends Error {
  constructor() {
    super("this daemon is updating and takes no new leases");
    this.name = "DaemonUpdatingError";
  }
}

export class NukeCancelledError extends Error {
  constructor() {
    super("Request cancelled by nuke");
    this.name = "NukeCancelledError";
  }
}

export class PhysicalUnknownModelError extends UnknownModelError {
  constructor(request: PhysicalRequest) {
    super(request.platform, request.model, request.model === undefined ? request.class : undefined);
    this.message = noPhysicalMatch(request).message;
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
