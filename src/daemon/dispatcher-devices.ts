import {
  DeviceBusyError,
  DeviceNotEnrollableError,
  isUnavailableInput,
  toDriverDevice,
  UnknownEnrolledDeviceError,
  UnknownLeaseError,
  type PhysicalEnrollment,
} from "../core/index.js";
import { DispatchError } from "./dispatch.js";
import type { DispatcherOptions, Handler } from "./dispatcher-options.js";
import { rotationRefusal } from "./rotation-refusal.js";

export class DeviceHandlers {
  constructor(private readonly options: DispatcherOptions) {}

  #leaseIsActive(leaseId: string): boolean {
    return this.options.registry.snapshot.leases.some((candidate) => candidate.id === leaseId);
  }

  readonly deviceRotate: Handler<"device.rotate"> = async (input) => {
    if (this.options.inputs === undefined) {
      throw new DispatchError("INTERNAL", "Device input is unavailable");
    }
    const lease = this.options.registry.snapshot.leases.find(
      (candidate) => candidate.id === input.leaseId,
    );
    if (lease === undefined) throw new UnknownLeaseError(input.leaseId);
    const record = this.options.registry.snapshot.devices.find(
      (candidate) => candidate.id === lease.deviceId,
    );
    if (record === undefined) throw new UnknownLeaseError(input.leaseId);
    const refusal = rotationRefusal(input.leaseId, record.spec);
    if (refusal !== undefined) throw refusal;
    try {
      const held = await this.options.inputs.leaseInput(
        input.leaseId,
        record.spec.platform,
        toDriverDevice(record),
      );
      try {
        if (isUnavailableInput(held.input)) throw new Error(held.input.unavailable);
        if (!this.#leaseIsActive(input.leaseId)) throw new UnknownLeaseError(input.leaseId);
        await held.input.send({ kind: "orientation", orientation: input.orientation });
      } finally {
        held.release();
      }
    } catch (error) {
      if (error instanceof UnknownLeaseError) throw error;
      throw inputUnavailable(input.leaseId, error);
    }
    return { leaseId: input.leaseId, orientation: input.orientation };
  };

  readonly deviceAdd: Handler<"device.add"> = async (input) => {
    try {
      const { device, reenrolled } = await this.#requireEnrollment().add(input.platform, input.id);
      return {
        appCount: device.enrolledApps.length,
        class: device.spec.class,
        driverDeviceId: device.driverDeviceId,
        id: device.id,
        model: device.spec.model,
        osVersion: device.spec.osVersion,
        platform: device.spec.platform,
        reenrolled,
      };
    } catch (error: unknown) {
      throw describeEnrollmentError(error);
    }
  };

  readonly deviceRemove: Handler<"device.remove"> = async (input) => {
    try {
      const device = await this.#requireEnrollment().remove(input.id);
      return { driverDeviceId: device.driverDeviceId, id: device.id };
    } catch (error: unknown) {
      throw describeEnrollmentError(error);
    }
  };

  #requireEnrollment(): Pick<PhysicalEnrollment, "add" | "remove"> {
    if (this.options.enrollment === undefined) {
      throw new DispatchError("INTERNAL", "Device enrollment is unavailable");
    }
    return this.options.enrollment;
  }
}

export function describeEnrollmentError(error: unknown): unknown {
  if (error instanceof DeviceNotEnrollableError) {
    return new DispatchError("DEVICE_NOT_ENROLLABLE", error.message, {
      id: error.id,
      platform: error.platform,
      reason: error.reason,
      ...(error.canonicalId === undefined ? {} : { canonicalId: error.canonicalId }),
    });
  }
  if (error instanceof DeviceBusyError) {
    return new DispatchError("DEVICE_BUSY", error.message, {
      id: error.id,
      reason: error.reason,
    });
  }
  if (error instanceof UnknownEnrolledDeviceError) {
    return new DispatchError("UNKNOWN_DEVICE", error.message, { id: error.id });
  }
  return error;
}

const INPUT_REASON_MAX = 200;

function inputUnavailable(leaseId: string, error: unknown): DispatchError {
  const text = error instanceof Error ? error.message : String(error);
  const reason = text === "" ? "unknown error" : text.slice(0, INPUT_REASON_MAX);
  return new DispatchError(
    "INPUT_UNAVAILABLE",
    `Lease ${leaseId}'s simulator cannot take input: ${reason}`,
    { leaseId, reason },
  );
}
