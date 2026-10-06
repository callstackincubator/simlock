import type { RunningCapacity } from "../capacity/index.js";
import {
  type DeviceRecord,
  fits,
  type LeaseRecord,
  mayBeGranted,
  specMode,
  type WaitingDemand,
} from "../domain.js";
import { compareLeastRecentlyUsed } from "../idle-order.js";

/** What one pass acts on: shut a running device down, or boot a shut-down one back. */
export interface WarmProposal {
  readonly action: "shutdown" | "boot";
  readonly deviceId: string;
  readonly reason: "over-budget" | "disabled" | "waiting-request" | "recently-released";
}

export interface WarmPolicyView {
  readonly devices: readonly DeviceRecord[];
  readonly leases: readonly LeaseRecord[];
  /** The requests with no device yet, oldest first: waiting (`new`, `queued`) or in flight. */
  readonly waiting: readonly WaitingDemand[];
  readonly capacity: RunningCapacity;
  readonly isClaimed: (deviceId: string) => boolean;
  readonly config: {
    readonly enabled: boolean;
    readonly reserveRunning: { readonly ios: number; readonly android: number };
    readonly shutdownAfterMs: number;
  };
  readonly now: number;
  /**
   * A device is on its way to a lease: booted, `ready` and claimed, still counted as running
   * and as reserved until the grant. The budget reads one over for that moment, so no shutdown
   * is proposed on it.
   */
  readonly handoffInFlight: boolean;
  /**
   * Shut-down devices an operator reset (`nuke`) stopped. They were released a moment ago, but
   * the reset's point is that they stay down, so they are never booted back unasked.
   */
  readonly resetDevices: ReadonlySet<string>;
}

type Slots = { global: number; ios: number; android: number };

/**
 * The one place the pool decides what to shut down and what to boot back. Pure: reads the view,
 * returns proposals in the order they are to run; the converger revalidates each before it acts.
 *
 * The budget is the running limit minus every slot a leased, reclaiming, quarantined or reserved
 * device holds, which `RunningCapacity` already totals; a `ready` idle device is the only thing
 * that is shut down to bring it back under, and only an idle `shutdown` device is booted into a
 * slot that is free. The operator's `reserveRunning` takes slots off that budget for idle devices
 * only (see `reservedOf`).
 */
export function evaluate(view: WarmPolicyView): readonly WarmProposal[] {
  const leased = new Set(view.leases.map((lease) => lease.deviceId));
  const idle = (device: DeviceRecord): boolean =>
    !leased.has(device.id) && !view.isClaimed(device.id);
  const running = view.devices
    .filter((device) => device.state === "ready" && idle(device))
    .sort(compareLeastRecentlyUsed);

  if (!view.config.enabled) {
    return running.map((device) => ({
      action: "shutdown",
      deviceId: device.id,
      reason: "disabled",
    }));
  }

  const room = roomOf(view.capacity);
  const held = reservedOf(view);
  const shutdowns = view.handoffInFlight ? [] : overBudget(view, running, room, held);

  const bootable = view.devices.filter(
    (device) => device.state === "shutdown" && mayBeGranted(device) && idle(device),
  );
  return [...shutdowns, ...boots(view, running, bootable, room, held)];
}

/**
 * The running slots idle warm devices may not fill: the operator's reserve for each platform,
 * never more than that platform's own limit, and for the global budget their sum. A request is
 * not an idle warm device, so `room` itself does not carry it.
 */
function reservedOf(view: WarmPolicyView): Slots {
  const reserve = (platform: "ios" | "android"): number =>
    Math.min(view.config.reserveRunning[platform], view.capacity[platform].maxRunning);
  return {
    android: reserve("android"),
    global: reserve("ios") + reserve("android"),
    ios: reserve("ios"),
  };
}

function roomOf(capacity: RunningCapacity): Slots {
  const room = (entry: RunningCapacity["global"]): number =>
    entry.maxRunning - entry.running - entry.reserved;
  return {
    android: room(capacity.android),
    global: room(capacity.global),
    ios: room(capacity.ios),
  };
}

function release(room: Slots, device: DeviceRecord): void {
  room.global += 1;
  room[device.spec.platform] += 1;
}

function claim(room: Slots, device: DeviceRecord): void {
  room.global -= 1;
  room[device.spec.platform] -= 1;
}

function hasRoom(room: Slots, device: DeviceRecord): boolean {
  return room.global >= 1 && room[device.spec.platform] >= 1;
}

/** Whether an idle warm device may take a slot: one beyond what the reserve holds back. */
function hasWarmRoom(room: Slots, held: Slots, device: DeviceRecord): boolean {
  const platform = device.spec.platform;
  return room.global - held.global >= 1 && room[platform] - held[platform] >= 1;
}

/** Whether `device` is one a waiting request would be granted: it fits and is in the pool mode. */
function serves(device: DeviceRecord, demand: WaitingDemand): boolean {
  return (
    mayBeGranted(device) &&
    specMode(device.spec) === demand.mode &&
    fits(demand.requirement, device.spec, demand.classOf)
  );
}

/**
 * Shutdowns that bring every over-budget platform and the global count back under, least
 * recently used first, never a device that serves a waiting request. A platform that is over
 * takes its own devices first; the global count then takes the least recently used of any.
 * Each proposal gives its slot back in `room`, which the boots then read. The reserve in `held`
 * is part of the budget: idle devices that fill a reserved slot are over it.
 */
function overBudget(
  view: WarmPolicyView,
  running: readonly DeviceRecord[],
  room: Slots,
  held: Slots,
): WarmProposal[] {
  const proposals: WarmProposal[] = [];
  const candidates = running.filter(
    (device) => !view.waiting.some((demand) => !demand.inFlight && serves(device, demand)),
  );
  const nextVictim = (): DeviceRecord | undefined =>
    candidates.find((device) => room[device.spec.platform] - held[device.spec.platform] < 0) ??
    (room.global - held.global < 0 ? candidates[0] : undefined);
  for (let victim = nextVictim(); victim !== undefined; victim = nextVictim()) {
    candidates.splice(candidates.indexOf(victim), 1);
    release(room, victim);
    proposals.push({ action: "shutdown", deviceId: victim.id, reason: "over-budget" });
  }
  return proposals;
}

/**
 * Boots into the slots that are free: first one device for the request at the head of the queue,
 * then the shut-down devices released less than `idle.shutdownAfterMs` ago, most recently released
 * first. A device that does not fit the free room on its platform is passed over. Slots that a
 * waiting request no idle device serves is about to take are held back from the second kind, and
 * so are the slots the reserve holds: the first kind is a request's, not an idle device's.
 */
function boots(
  view: WarmPolicyView,
  running: readonly DeviceRecord[],
  bootable: readonly DeviceRecord[],
  room: Slots,
  held: Slots,
): WarmProposal[] {
  const proposals: WarmProposal[] = [];
  const taken = new Set<string>();
  const boot = (device: DeviceRecord, reason: WarmProposal["reason"]): void => {
    taken.add(device.id);
    claim(room, device);
    proposals.push({ action: "boot", deviceId: device.id, reason });
  };

  const unserved: WaitingDemand[] = [];
  view.waiting.forEach((demand, position) => {
    // Only the first request in the line, the queue head, whether or not it is in flight, is
    // granted a device (strict FIFO): a device booted for one behind it would sit idle, be shut
    // down by the idle rule, and be booted again. The others still hold a slot below.
    const device =
      position === 0 && !demand.inFlight
        ? bootable.find(
            (candidate) =>
              !taken.has(candidate.id) && hasRoom(room, candidate) && serves(candidate, demand),
          )
        : undefined;
    if (device !== undefined) boot(device, "waiting-request");
    else if (demand.inFlight || !running.some((candidate) => serves(candidate, demand))) {
      unserved.push(demand);
    }
  });
  // A request no device serves will take a free slot of its own (it boots a device or creates
  // one), so those slots are not the pool's to fill with a device nobody asked for.
  for (const demand of unserved) {
    room.global -= 1;
    room[demand.platform] -= 1;
  }

  const recent = bootable
    .filter(
      (device) =>
        !taken.has(device.id) &&
        !view.resetDevices.has(device.id) &&
        view.now - (device.lastLeaseEndedAt ?? Number.NEGATIVE_INFINITY) <
          view.config.shutdownAfterMs,
    )
    .sort((left, right) => compareLeastRecentlyUsed(right, left));
  for (const device of recent) {
    if (hasWarmRoom(room, held, device)) boot(device, "recently-released");
  }
  return proposals;
}
