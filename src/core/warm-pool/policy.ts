import type { CapacityRefusalReason, RunningCapacity } from "../capacity/index.js";
import {
  type DeviceRecord,
  type DeviceSpec,
  fits,
  type LeaseRecord,
  mayBeGranted,
  readySince,
  sameSpec,
  specMode,
  type TargetRefusal,
  type WaitingDemand,
} from "../domain.js";
import { compareLeastRecentlyUsed } from "../idle-order.js";

/**
 * What one pass acts on: shut a running device down, boot a shut-down one back, or create a new
 * one. A boot or creation for a target carries the target's spec, which the converger keys its
 * failure schedule and its boot cap by.
 */
export type WarmProposal =
  | {
      readonly action: "shutdown" | "boot";
      readonly deviceId: string;
      readonly reason:
        | "over-budget"
        | "disabled"
        | "waiting-request"
        | "recently-released"
        | "target"
        | "never-leased-idle";
      readonly target?: DeviceSpec;
    }
  | {
      readonly action: "provision";
      readonly spec: DeviceSpec;
      readonly reason: "target";
      readonly target: DeviceSpec;
    };

/** A proposal that acts on a device already in the registry: a shutdown or a boot. */
type DeviceProposal = Extract<WarmProposal, { readonly deviceId: string }>;

/** A target that resolved: the spec a request for it resolves to, and how many to keep ready. */
export interface ResolvedTarget {
  readonly spec: DeviceSpec;
  readonly count: number;
}

/** Why a target has fewer ready devices than its count, when nothing but time will not fix it. */
export type TargetShort =
  | TargetRefusal
  | "boot-failed"
  | "running-limit"
  | "device-limit"
  | "ram-budget"
  | "reserve";

/** One target as a pass left it: what it asked for, how many are ready, and why not more. */
export interface TargetReport {
  readonly target: string;
  readonly spec?: DeviceSpec;
  readonly count: number;
  readonly ready: number;
  readonly short?: TargetShort;
  readonly message?: string;
}

/** What `evaluate` decides: the actions to run in order, and every resolved target's state. */
export interface WarmPlan {
  readonly proposals: readonly WarmProposal[];
  readonly targets: readonly TargetReport[];
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
    readonly maxConcurrentBoots: number;
  };
  readonly now: number;
  /** The targets to plan for this pass; the policy merges those of one spec (`mergeTargets`). */
  readonly targets: readonly ResolvedTarget[];
  /** Targets whose resolution failed and that keep a stale spec: their devices are spared. */
  readonly spared: readonly ResolvedTarget[];
  /** The spec of each target boot or creation still running: they count toward the boot cap. */
  readonly inFlight: readonly DeviceSpec[];
  /** The failure schedule: whether a spec may be tried now. */
  readonly retry: { mayAttempt(spec: DeviceSpec, now: number): boolean };
  /** What the capacity strategy refuses besides the running slots `capacity` already totals. */
  readonly admit: {
    create(spec: DeviceSpec): CapacityRefusalReason | undefined;
    boot(device: DeviceRecord): CapacityRefusalReason | undefined;
  };
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
 * The one place the pool decides what to shut down, what to boot back and what to create for a
 * target. Pure: reads the view, returns proposals in the order they are to run and the state of
 * every target; the converger revalidates each proposal before it acts.
 *
 * The budget is the running limit minus every slot a leased, reclaiming, quarantined or reserved
 * device holds, which `RunningCapacity` already totals; a `ready` idle device is the only thing
 * that is shut down to bring it back under, and only an idle `shutdown` device is booted into a
 * slot that is free. The operator's `reserveRunning` takes slots off that budget for idle devices
 * only (see `reservedOf`). Apart from the budget, an idle device that never served a lease and that
 * no target keeps is shut down once it has been ready past `idle.shutdownAfterMs`
 * (`neverLeasedIdle`).
 */
export function evaluate(view: WarmPolicyView): WarmPlan {
  const idle = idlePredicate(view.leases, view.isClaimed);
  const running = view.devices
    .filter((device) => device.state === "ready" && idle(device))
    .sort(compareLeastRecentlyUsed);

  if (!view.config.enabled) {
    return {
      proposals: running.map((device) => ({
        action: "shutdown",
        deviceId: device.id,
        reason: "disabled",
      })),
      targets: [],
    };
  }

  const room = roomOf(view.capacity);
  const held = reservedOf(view);
  const shutdowns = view.handoffInFlight ? [] : overBudget(view, running, room, held);

  const bootable = view.devices.filter(
    (device) => device.state === "shutdown" && mayBeGranted(device) && idle(device),
  );
  const keeps = boots(view, running, bootable, room, held);
  const targets = mergeTargets(view.targets);
  const unneeded = neverLeasedIdle(view, running, shutdowns, room);
  const wanted = planTargets(view, targets, bootable, keeps, room, held, idle);
  return {
    proposals: [...shutdowns, ...keeps, ...unneeded, ...wanted.proposals],
    targets: wanted.reports,
  };
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
): DeviceProposal[] {
  const proposals: DeviceProposal[] = [];
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
): DeviceProposal[] {
  const proposals: DeviceProposal[] = [];
  const taken = new Set<string>();
  const boot = (device: DeviceRecord, reason: DeviceProposal["reason"]): void => {
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

/** The targets with those that resolved to one spec merged into one, counts summed. */
function mergeTargets(targets: readonly ResolvedTarget[]): ResolvedTarget[] {
  const merged: ResolvedTarget[] = [];
  for (const target of targets) {
    const index = merged.findIndex((entry) => sameSpec(entry.spec, target.spec));
    const existing = merged[index];
    if (existing === undefined) merged.push(target);
    else merged[index] = { ...existing, count: existing.count + target.count };
  }
  return merged;
}

/**
 * A target's ready devices: of its kind (`sameSpec`), ready, with no lease and no claim, and not
 * a spent `fresh` one, oldest first. The count of them is what the target has; the first `count`
 * are the ones it keeps.
 */
function readyOfKind(
  devices: readonly DeviceRecord[],
  isIdle: (device: DeviceRecord) => boolean,
  spec: DeviceSpec,
): DeviceRecord[] {
  return devices
    .filter(
      (device) =>
        device.state === "ready" &&
        isIdle(device) &&
        mayBeGranted(device) &&
        sameSpec(device.spec, spec),
    )
    .sort((left, right) => left.createdAt - right.createdAt);
}

/**
 * The devices a target keeps: for each target, its ready unleased devices of that kind, oldest
 * first, up to its count. The one place the pool and the idle shutdown timer agree on which
 * devices a target counts.
 */
function idlePredicate(
  leases: readonly LeaseRecord[],
  isClaimed: (deviceId: string) => boolean,
): (device: DeviceRecord) => boolean {
  const leased = new Set(leases.map((lease) => lease.deviceId));
  return (device) => !leased.has(device.id) && !isClaimed(device.id);
}

export function targetedDevices(input: {
  readonly devices: readonly DeviceRecord[];
  readonly leases: readonly LeaseRecord[];
  readonly isClaimed: (deviceId: string) => boolean;
  readonly targets: readonly ResolvedTarget[];
}): ReadonlySet<string> {
  const isIdle = idlePredicate(input.leases, input.isClaimed);
  return new Set(
    mergeTargets(input.targets).flatMap((target) =>
      readyOfKind(input.devices, isIdle, target.spec)
        .slice(0, target.count)
        .map((device) => device.id),
    ),
  );
}

/**
 * Shutdowns for the ready, unleased devices that never served a lease and that no target keeps,
 * once they have been ready longer than `idle.shutdownAfterMs`. The cleanup reaper times an idle
 * device from the end of its last lease, so it never sees one of these; this is the one rule that
 * does. A device a waiting request is about to be granted is spared, as in the budget's choice.
 */
function neverLeasedIdle(
  view: WarmPolicyView,
  running: readonly DeviceRecord[],
  proposed: readonly DeviceProposal[],
  room: Slots,
): DeviceProposal[] {
  const kept = targetedDevices({ ...view, targets: [...view.targets, ...view.spared] });
  const already = new Set(proposed.map((proposal) => proposal.deviceId));
  const proposals: DeviceProposal[] = [];
  for (const device of running) {
    if (
      device.lastLeaseEndedAt !== undefined ||
      kept.has(device.id) ||
      already.has(device.id) ||
      view.now - readySince(device) <= view.config.shutdownAfterMs ||
      view.waiting.some((demand) => !demand.inFlight && serves(device, demand))
    ) {
      continue;
    }
    release(room, device);
    proposals.push({ action: "shutdown", deviceId: device.id, reason: "never-leased-idle" });
  }
  return proposals;
}

/** Why a slot of `platform` is not free for an idle warm device, when it is not. */
function slotShort(
  room: Slots,
  held: Slots,
  platform: "ios" | "android",
): "running-limit" | "reserve" | undefined {
  if (room.global < 1 || room[platform] < 1) return "running-limit";
  if (room.global - held.global < 1 || room[platform] - held[platform] < 1) return "reserve";
  return undefined;
}

/** What the capacity strategy's refusal means for a target's report. */
function shortOf(refusal: CapacityRefusalReason | undefined): TargetShort | undefined {
  if (refusal === undefined) return undefined;
  return refusal === "device-limit" || refusal === "ram-budget" ? refusal : "running-limit";
}

/** What `planTargets` shares across targets: the room left, the devices taken, the boots begun. */
interface TargetPlan {
  readonly view: WarmPolicyView;
  readonly bootable: readonly DeviceRecord[];
  readonly room: Slots;
  readonly held: Slots;
  readonly taken: Set<string>;
  readonly proposals: WarmProposal[];
  /** Pool boots and creations running or proposed, which `maxConcurrentBoots` bounds. */
  started: number;
}

/**
 * What each target still needs, and the boots and creations that fill it: a shut-down device of
 * its kind is booted before a new one is created, never while a request is queued on its
 * platform, never while its spec is held back after a failure, and never past the slots, the
 * device limit and RAM the capacity allows, nor past `maxConcurrentBoots` pool boots at once. A
 * target never shuts a device down: what it cannot fit it reports short.
 */
function planTargets(
  view: WarmPolicyView,
  targets: readonly ResolvedTarget[],
  bootable: readonly DeviceRecord[],
  keeps: readonly DeviceProposal[],
  room: Slots,
  held: Slots,
  isIdle: (device: DeviceRecord) => boolean,
): { proposals: WarmProposal[]; reports: TargetReport[] } {
  const keepBoots = keeps.map((proposal) => proposal.deviceId);
  const plan: TargetPlan = {
    bootable,
    held,
    proposals: [],
    room,
    started: view.inFlight.length + keepBoots.length,
    taken: new Set(keepBoots),
    view,
  };
  const pending = (spec: DeviceSpec): number =>
    view.inFlight.filter((flying) => sameSpec(flying, spec)).length +
    keepBoots.filter((id) =>
      view.devices.some((device) => device.id === id && sameSpec(device.spec, spec)),
    ).length;
  const reports = targets.map(({ count, spec }): TargetReport => {
    const ready = readyOfKind(view.devices, isIdle, spec).length;
    const report = { count, ready, spec, target: describeTarget(spec) };
    const filling = pending(spec);
    const missing = count - ready - filling;
    const short = missing > 0 ? fillTarget(plan, spec, missing, filling > 0) : undefined;
    return short === undefined ? report : { ...report, short };
  });
  return { proposals: plan.proposals, reports };
}

/**
 * Adds the boots and creations a target is missing. The reason it is short, when a pass could do
 * nothing for it: a target with a boot already running or one proposed here is still filling, and
 * one waiting behind a queued request is waiting, and neither is short, whatever stopped the rest.
 */
function fillTarget(
  plan: TargetPlan,
  spec: DeviceSpec,
  missing: number,
  filling: boolean,
): TargetShort | undefined {
  // A request queued on this platform is served first; the target waits, and is not short.
  if (plan.view.waiting.some((demand) => !demand.inFlight && demand.platform === spec.platform)) {
    return undefined;
  }
  if (!plan.view.retry.mayAttempt(spec, plan.view.now)) return filling ? undefined : "boot-failed";
  let added = 0;
  for (let left = missing; left > 0 && plan.started < plan.view.config.maxConcurrentBoots; left--) {
    const refused = addOne(plan, spec);
    if (refused !== undefined) return added > 0 || filling ? undefined : refused;
    added += 1;
  }
  return undefined;
}

/** Proposes one boot of a shut-down device of the kind, else one creation; or why it cannot. */
function addOne(plan: TargetPlan, spec: DeviceSpec): TargetShort | undefined {
  const shutDown = plan.bootable.find(
    (device) =>
      !plan.taken.has(device.id) &&
      !plan.view.resetDevices.has(device.id) &&
      sameSpec(device.spec, spec),
  );
  // The order a user reads: device limit, running limit, reserve, then RAM budget.
  const capacity = shortOf(
    shutDown === undefined ? plan.view.admit.create(spec) : plan.view.admit.boot(shutDown),
  );
  const refused =
    capacity === "device-limit"
      ? capacity
      : (slotShort(plan.room, plan.held, spec.platform) ?? capacity);
  if (refused !== undefined) return refused;
  plan.room.global -= 1;
  plan.room[spec.platform] -= 1;
  plan.started += 1;
  if (shutDown === undefined) {
    plan.proposals.push({ action: "provision", reason: "target", spec, target: spec });
    return undefined;
  }
  plan.taken.add(shutDown.id);
  plan.proposals.push({ action: "boot", deviceId: shutDown.id, reason: "target", target: spec });
  return undefined;
}

/** A target or a spec as one line: platform, model, OS and mode, the parts it names. */
export function describeTarget(target: {
  readonly platform: string;
  readonly model: string;
  readonly osVersion?: string | undefined;
  readonly mode?: string | undefined;
}): string {
  return [target.platform, target.model, target.osVersion, target.mode]
    .filter((part) => part !== undefined)
    .join(" ");
}
