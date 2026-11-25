import { readsEveryLease } from "../contract/index.js";
import {
  isStalledTransition,
  transitionEnteredAt,
  type DeviceRecord,
  type LatestPresence,
  type PhysicalClass,
} from "../core/index.js";
import type { DispatchSession } from "./dispatch.js";
import type { DispatcherOptions } from "./dispatcher-options.js";

// why: an agent token must not learn other principals' leases or requester ids; viewer and admin see all.
export function leasesFor(options: DispatcherOptions, session: DispatchSession) {
  return options.registry.snapshot.leases.filter(
    (lease) => readsEveryLease(session.role) || lease.ownerId === session.principal,
  );
}

// why: a waiting entry carries no owner, so the queue's recorded owner of its requester on that row's platform decides.
export function waitingFor(options: DispatcherOptions, session: DispatchSession) {
  return options.queue
    .waitingRequests()
    .filter(
      (request) =>
        readsEveryLease(session.role) ||
        options.queue.pendingRequestOwner(request.requesterId, request.spec.platform) ===
          session.principal,
    );
}

export function decorateDevice(
  options: DispatcherOptions,
  device: DeviceRecord,
): DeviceRecord & {
  readonly class?: PhysicalClass;
  readonly servesDefaultMode: boolean;
  readonly presence?: LatestPresence;
  readonly transitionAgeMs?: number;
  readonly stalled?: true;
} {
  // why: `reclaimingSince` only ages a transition: it stays off the wire (`transitionAgeMs` carries it).
  const { reclaimingSince: _internal, ...onTheWire } = device as DeviceRecord & {
    readonly reclaimingSince?: number;
  };
  const presence = device.physical ? options.presence?.(device.driverDeviceId) : undefined;
  const decorated = {
    ...onTheWire,
    ...(device.physical ? { class: device.spec.class } : {}),
    ...(presence === undefined ? {} : { presence }),
    servesDefaultMode: options.deviceModes.servesDefaultMode(device.spec),
  };
  const enteredAt = transitionEnteredAt(device);
  if (enteredAt === undefined) return decorated;
  const now = options.clock.now();
  return {
    ...decorated,
    transitionAgeMs: now - enteredAt,
    ...(isStalled(options, device, now) ? { stalled: true as const } : {}),
  };
}

function isStalled(options: DispatcherOptions, device: DeviceRecord, now: number): boolean {
  const stalls = options.stalls;
  if (stalls === undefined) return false;
  return isStalledTransition({
    claims: stalls.claims,
    config: options.config.stalledTransition,
    device,
    driver: stalls.drivers.find((driver) => driver.platform === device.spec.platform),
    now,
  });
}
