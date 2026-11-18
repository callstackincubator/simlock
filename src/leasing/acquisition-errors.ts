import {
  type DeviceMode,
  type DeviceRequest,
  noPhysicalMatch,
  type PhysicalRequest,
  UnknownModelError,
} from "../core/index.js";
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

/** why: a plain lease on a platform whose `<platform>.virtualDevices` is false; the message names the key and both ways to ask for a physical device (ADR 0084 §2). */
export class VirtualDevicesOffError extends UnknownModelError {
  constructor(request: Pick<DeviceRequest, "class" | "model" | "platform">) {
    super(request.platform, request.model, request.model === undefined ? request.class : undefined);
    this.name = "VirtualDevicesOffError";
    this.message =
      `This worker serves only enrolled physical ${request.platform} devices ` +
      `(${request.platform}.virtualDevices is false); ask for a physical device ` +
      "(--physical, or physical: true)";
  }
}

/** why: an iOS lease or target whose resolved mode `ios.modes` does not list (ADR 0082 §3); mapped to `MODE_UNAVAILABLE`, and the warm pool reads it as `mode-unavailable`. */
export class ModeUnavailableError extends Error {
  constructor(
    readonly mode: DeviceMode,
    readonly served: readonly DeviceMode[],
    message: string,
  ) {
    super(message);
    this.name = "ModeUnavailableError";
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
