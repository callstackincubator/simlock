import type {
  DeviceRecord,
  DeviceState,
  LeaseRecord,
  LeaseRequestRecord,
  VirtualDevice,
} from "./domain.js";
import { RegistryEventError } from "./registry-errors.js";
import type { ComponentRecord, RegistryDeviceEvent } from "./registry-types.js";

export function isExpired(device: DeviceRecord, now: number, retentionMs: number): boolean {
  return device.deletedAt !== undefined && now - device.deletedAt > retentionMs;
}

export function componentKey(record: ComponentRecord): string {
  return `${record.platform}\0${record.version}`;
}

/** why: records are immutable, so a record that is not the committed object has changed and one that is not in `after` is gone. */
export function changes<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (record: T) => string,
): { readonly changed: T[]; readonly removed: string[] } {
  const committed = new Map(before.map((record) => [keyOf(record), record]));
  const kept = new Set(after.map(keyOf));
  return {
    changed: after.filter((record) => committed.get(keyOf(record)) !== record),
    removed: [...committed.keys()].filter((key) => !kept.has(key)),
  };
}

export function cloneDevice<T extends DeviceRecord>(device: T): T {
  return { ...device, spec: { ...device.spec } } as T;
}

export function isVirtual(device: DeviceRecord): device is VirtualDevice {
  return !device.physical;
}

/** why: the one place a cause goes when its device leaves quarantine, however it left. */
export function withoutCauseUnlessQuarantined(device: DeviceRecord): DeviceRecord {
  if (device.state === "quarantined" || device.quarantineCause === undefined) return device;
  const { quarantineCause: _cause, ...rest } = device;
  return rest as DeviceRecord;
}

export function cloneLease(lease: LeaseRecord): LeaseRecord {
  return { ...lease };
}

export function cloneComponent(record: ComponentRecord): ComponentRecord {
  return { ...record, receipt: { ...record.receipt } };
}

export function cloneLeaseRequest(record: LeaseRequestRecord): LeaseRequestRecord {
  return { ...record, request: { ...record.request } };
}

export function assertTransitionEvent(
  device: DeviceRecord,
  to: DeviceState,
  event: RegistryDeviceEvent | undefined,
): void {
  const expectedEvent = eventForTransition(device.state, to);
  if (event?.event !== expectedEvent) {
    throw new RegistryEventError(
      `Transition from ${device.state} to ${to} requires ${expectedEvent ?? "no"} device event`,
    );
  }
  if (event !== undefined && event.payload.deviceId !== device.id) {
    throw new RegistryEventError(`Device event payload does not match device: ${device.id}`);
  }
}

function eventForTransition(
  from: DeviceState,
  to: DeviceState,
): RegistryDeviceEvent["event"] | undefined {
  if (to === "absent") {
    return "device.absence-detected";
  }
  if (from === "absent" && to === "reclaiming") {
    return "device.returned";
  }
  if (from === "reclaiming") {
    return "device.reclaimed";
  }
  if (to === "ready") {
    return "device.ready";
  }
  if (to === "shutdown") {
    return "device.shutdown";
  }
  if (to === "deleted") {
    return "device.deleted";
  }
  return undefined;
}
