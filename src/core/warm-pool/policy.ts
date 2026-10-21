import type { CapacityRefusalReason, RunningCapacity } from "../capacity/index.js";
import {
  type VirtualDevice,
  type VirtualSpec,
  fits,
  type LeaseRecord,
  mayBeGranted,
  readySince,
  sameSpec,
  specMode,
  type Platform,
  type TargetRefusal,
  type WaitingDemand,
} from "../domain.js";
import { compareLeastRecentlyUsed } from "../idle-order.js";
import type { LearnedKind } from "./learned.js";

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
        | "displaced"
        | "target"
        | "never-leased-idle";
      readonly target?: VirtualSpec;
    }
  | {
      readonly action: "provision";
      readonly spec: VirtualSpec;
      readonly reason: "target" | "waiting-request";
      readonly target: VirtualSpec;
    };

/** A proposal that acts on a device already in the registry: a shutdown or a boot. */
type DeviceProposal = Extract<WarmProposal, { readonly deviceId: string }>;

/** A target that resolved: the spec a request for it resolves to, and how many to keep ready. */
export interface ResolvedTarget {
  readonly spec: VirtualSpec;
  readonly count: number;
}

/** Why a target has fewer ready devices than its count, when nothing but time will not fix it. */
export type TargetShort =
  | TargetRefusal
  | "disabled"
  | "boot-failed"
  | "running-limit"
  | "device-limit"
  | "ram-budget"
  | "reserve";

/** A target's kind as reported: the platform, the exact model, and the OS and mode it names. */
export interface TargetKind {
  readonly platform: "ios" | "android";
  readonly model: string;
  readonly osVersion?: string;
  readonly mode: "slim" | "full";
}

/** One target as a pass left it: what it asked for, how many are ready, and why not more. */
export interface TargetReport {
  readonly target: string;
  /** The kind as resolved, or as configured for a target that did not resolve. */
  readonly kind: TargetKind;
  readonly spec?: VirtualSpec;
  readonly origin: "configured" | "learned";
  readonly count: number;
  readonly configuredCount: number;
  readonly ready: number;
  /** Boots and creations of the kind running or proposed in the pass. */
  readonly booting: number;
  readonly short?: TargetShort;
  readonly message?: string;
}

/** What `evaluate` decides: the actions to run in order, and every resolved target's state. */
export interface WarmPlan {
  readonly proposals: readonly WarmProposal[];
  readonly targets: readonly TargetReport[];
}

export interface WarmPolicyView {
  readonly devices: readonly VirtualDevice[];
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
  readonly learned: readonly LearnedKind[];
  /** why: learned kinds kept but planned for nothing this pass, as no catalog read has listed their platform yet (ADR 0038 §4). */
  readonly unplanned: readonly VirtualSpec[];
  /** why: the spec of each boot or creation of the pool still running, for a target or a waiter; they count toward the boot cap. */
  readonly inFlight: readonly VirtualSpec[];
  readonly onItsWay: readonly { readonly spec: VirtualSpec; readonly deviceId?: string }[];
  /** The failure schedule: whether a spec may be tried now. */
  readonly retry: { mayAttempt(spec: VirtualSpec, now: number): boolean };
  /** What the capacity strategy refuses besides the running slots `capacity` already totals. */
  readonly admit: {
    /** why: `down` names devices the plan has already shut down, which no longer hold their RAM. */
    create(spec: VirtualSpec, down?: ReadonlySet<string>): CapacityRefusalReason | undefined;
    boot(device: VirtualDevice, down?: ReadonlySet<string>): CapacityRefusalReason | undefined;
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
 * why: the one place the pool decides what to shut down, what to boot back and what to create for a
 * target. Pure: reads the view, returns proposals in the order they are to run and the state of
 * every target; the converger revalidates each proposal before it acts.
 *
 * The budget is the running limit minus every slot a leased, reclaiming, quarantined or reserved
 * device holds, which `RunningCapacity` already totals; a `ready` idle device is the only thing
 * that is shut down to bring it back under, and only an idle `shutdown` device is booted into a
 * slot that is free. The operator's `reserveRunning` takes slots off that budget for idle devices
 * only (see `reservedOf`). Apart from the budget, an idle device that never served a lease and that
 * no target or learned kind keeps is shut down once it has been ready past `idle.shutdownAfterMs`
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
  const queued = boots(view, running, bootable, room);
  const keeps = queued.proposals;
  const targets = mergeTargets(view.targets);
  const unneeded = neverLeasedIdle(view, running, shutdowns, room);
  const proposed = new Set([...shutdowns, ...unneeded].map((proposal) => proposal.deviceId));
  const sparedDevices = targetedDevices({ ...view, learned: [], targets: view.spared });
  const wanted = planTargets(
    view,
    plannedKinds(
      targets,
      view.learned.filter((kind) => !view.unplanned.some((spec) => sameSpec(spec, kind.spec))),
    ),
    bootable,
    queued,
    room,
    held,
    idle,
    view.handoffInFlight
      ? []
      : running.filter((device) => !proposed.has(device.id) && !sparedDevices.has(device.id)),
  );
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
  const reserve = reservedRunning(view.config, view.capacity);
  return { android: reserve.android, global: reserve.ios + reserve.android, ios: reserve.ios };
}

/**
 * The running slots the operator's reserve holds back on each platform: `reserveRunning`, never
 * more than that platform's own running limit. The one place the cap is decided; `doctor` reads it
 * too, to tell whether the targets fit what the reserve leaves.
 */
export function reservedRunning(
  config: { readonly reserveRunning: { readonly ios: number; readonly android: number } },
  capacity: Pick<RunningCapacity, "ios" | "android">,
): { readonly ios: number; readonly android: number } {
  return {
    android: Math.min(config.reserveRunning.android, capacity.android.maxRunning),
    ios: Math.min(config.reserveRunning.ios, capacity.ios.maxRunning),
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

function release(room: Slots, device: VirtualDevice): void {
  room.global += 1;
  room[device.spec.platform] += 1;
}

function claim(room: Slots, device: VirtualDevice): void {
  room.global -= 1;
  room[device.spec.platform] -= 1;
}

function hasRoom(room: Slots, device: VirtualDevice): boolean {
  return room.global >= 1 && room[device.spec.platform] >= 1;
}

/** Whether `device` is one a waiting request would be granted: it fits and is in the pool mode. */
function serves(device: VirtualDevice, demand: WaitingDemand): boolean {
  return mayBeGranted(device) && servesSpec(device.spec, demand);
}

function servesSpec(spec: VirtualSpec, demand: WaitingDemand): boolean {
  return specMode(spec) === demand.mode && fits(demand.requirement, spec, demand.classOf);
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
  running: readonly VirtualDevice[],
  room: Slots,
  held: Slots,
): DeviceProposal[] {
  const proposals: DeviceProposal[] = [];
  const candidates = running.filter(
    (device) => !view.waiting.some((demand) => !demand.inFlight && serves(device, demand)),
  );
  const nextVictim = (): VirtualDevice | undefined =>
    candidates.find((device) => room[device.spec.platform] - held[device.spec.platform] < 0) ??
    (room.global - held.global < 0 ? candidates[0] : undefined);
  for (let victim = nextVictim(); victim !== undefined; victim = nextVictim()) {
    candidates.splice(candidates.indexOf(victim), 1);
    release(room, victim);
    proposals.push({ action: "shutdown", deviceId: victim.id, reason: "over-budget" });
  }
  return proposals;
}

interface QueuePass {
  readonly proposals: WarmProposal[];
  readonly started: number;
  readonly stuck: ReadonlySet<Platform>;
}

interface QueueState {
  readonly view: WarmPolicyView;
  readonly bootable: readonly VirtualDevice[];
  readonly room: Slots;
  readonly proposals: WarmProposal[];
  readonly taken: Set<string>;
  readonly stuck: Set<Platform>;
  started: number;
}

/**
 * why: the queue is served in order, one device per waiter. A waiter behind the head gets a
 * shut-down device booted or a new one created, within `maxConcurrentBoots` counting the pool's
 * flights, each in-flight waiter and the head's own work; the head's creation stays leasing's.
 * Slots a waiting request no idle device serves is about to take are held back from the targets.
 */
function boots(
  view: WarmPolicyView,
  running: readonly VirtualDevice[],
  bootable: readonly VirtualDevice[],
  room: Slots,
): QueuePass {
  const state: QueueState = {
    bootable,
    proposals: [],
    room,
    started: view.inFlight.length + view.waiting.filter((demand) => demand.inFlight).length,
    stuck: new Set(),
    taken: new Set(),
    view,
  };
  const matched = new Set<VirtualDevice | WarmPolicyView["onItsWay"][number]>();
  let atHead = true;
  for (const demand of view.waiting) {
    const head: boolean = atHead;
    atHead = false;
    if (demand.inFlight) {
      holdSlot(room, demand.platform);
      continue;
    }
    const ready = running.find((candidate) => !matched.has(candidate) && serves(candidate, demand));
    const match = ready ?? onItsWayFor(view, matched, demand);
    if (match !== undefined) {
      matched.add(match);
      atHead = head && ready !== undefined;
    } else if (!bootForWaiter(state, demand)) {
      createForWaiter(state, demand, head);
      holdSlot(room, demand.platform);
    }
  }
  return { proposals: state.proposals, started: state.started, stuck: state.stuck };
}

function onItsWayFor(
  view: WarmPolicyView,
  matched: ReadonlySet<unknown>,
  demand: WaitingDemand,
): WarmPolicyView["onItsWay"][number] | undefined {
  return view.onItsWay.find((entry) => !matched.has(entry) && servesSpec(entry.spec, demand));
}

function holdSlot(room: Slots, platform: Platform): void {
  room.global -= 1;
  room[platform] -= 1;
}

function bootsOpen(state: QueueState): boolean {
  return state.started < state.view.config.maxConcurrentBoots;
}

function bootForWaiter(state: QueueState, demand: WaitingDemand): boolean {
  if (!bootsOpen(state)) return false;
  const device = state.bootable.find(
    (candidate) =>
      !state.taken.has(candidate.id) &&
      hasRoom(state.room, candidate) &&
      serves(candidate, demand) &&
      // why: the converger records a failed boot under the device's spec, not the waiter's.
      state.view.retry.mayAttempt(candidate.spec, state.view.now) &&
      state.view.admit.boot(candidate) === undefined,
  );
  if (device === undefined) return false;
  state.taken.add(device.id);
  claim(state.room, device);
  state.started += 1;
  state.proposals.push({ action: "boot", deviceId: device.id, reason: "waiting-request" });
  return true;
}

function createForWaiter(state: QueueState, demand: WaitingDemand, head: boolean): void {
  const { room, view } = state;
  const creatable =
    view.admit.create(demand.spec) === undefined &&
    room.global >= 1 &&
    room[demand.spec.platform] >= 1;
  if (head && creatable) {
    state.started += 1;
  } else if (
    !head &&
    creatable &&
    bootsOpen(state) &&
    view.retry.mayAttempt(demand.spec, view.now)
  ) {
    state.started += 1;
    state.proposals.push({
      action: "provision",
      reason: "waiting-request",
      spec: demand.spec,
      target: demand.spec,
    });
  } else state.stuck.add(demand.platform);
}

interface PlannedKind {
  readonly spec: VirtualSpec;
  readonly configuredCount: number;
  readonly learnedCount: number;
  readonly origin: "configured" | "learned";
}

// why: configured targets fill in config order, then learned kinds newest first; a learned kind of a configured target's spec is that entry, not a second one.
function plannedKinds(
  targets: readonly ResolvedTarget[],
  learned: readonly LearnedKind[],
): PlannedKind[] {
  const kinds: PlannedKind[] = targets.map((target) => ({
    configuredCount: target.count,
    learnedCount: 0,
    origin: "configured",
    spec: target.spec,
  }));
  for (const kind of learned) {
    const index = kinds.findIndex((entry) => sameSpec(entry.spec, kind.spec));
    const existing = kinds[index];
    if (existing === undefined) {
      kinds.push({
        configuredCount: 0,
        learnedCount: kind.count,
        origin: "learned",
        spec: kind.spec,
      });
    } else kinds[index] = { ...existing, learnedCount: kind.count };
  }
  return kinds;
}

/**
 * why: what a learned kind has: its ready idle devices, and the ones leased, reclaiming or under
 * an operation claim (a reclaim that has not yet given its claim up), which come back on their own.
 * A burst held at its peak so makes nothing more.
 */
function haveOfKind(
  view: WarmPolicyView,
  isIdle: (device: VirtualDevice) => boolean,
  spec: VirtualSpec,
): number {
  const leased = new Set(view.leases.map((lease) => lease.deviceId));
  const ready = new Set(readyOfKind(view.devices, isIdle, spec).map((device) => device.id));
  return view.devices.filter(
    (device) =>
      sameSpec(device.spec, spec) &&
      (ready.has(device.id) ||
        leased.has(device.id) ||
        device.state === "reclaiming" ||
        (device.state !== "provisioning" && view.isClaimed(device.id))),
  ).length;
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
  devices: readonly VirtualDevice[],
  isIdle: (device: VirtualDevice) => boolean,
  spec: VirtualSpec,
): VirtualDevice[] {
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

/** Whether a device has no lease and no operation claim on it. */
function idlePredicate(
  leases: readonly LeaseRecord[],
  isClaimed: (deviceId: string) => boolean,
): (device: VirtualDevice) => boolean {
  const leased = new Set(leases.map((lease) => lease.deviceId));
  return (device) => !leased.has(device.id) && !isClaimed(device.id);
}

interface DeviceCounts {
  readonly devices: readonly VirtualDevice[];
  readonly leases: readonly LeaseRecord[];
  readonly isClaimed: (deviceId: string) => boolean;
}

/** How many ready, unleased devices of `spec`'s kind there are: what a target report calls ready. */
export function readyCount(input: DeviceCounts, spec: VirtualSpec): number {
  return readyOfKind(input.devices, idlePredicate(input.leases, input.isClaimed), spec).length;
}

/** why: the reaper and pool must spare the same devices while queue FIFO delays their grant. */
export function targetedDevices(
  input: DeviceCounts & {
    readonly targets: readonly ResolvedTarget[];
    readonly learned: readonly LearnedKind[];
    readonly waiting: readonly WaitingDemand[];
  },
): ReadonlySet<string> {
  const isIdle = idlePredicate(input.leases, input.isClaimed);
  const kept = new Set(
    plannedKinds(mergeTargets(input.targets), input.learned).flatMap((kind) =>
      readyOfKind(input.devices, isIdle, kind.spec)
        .slice(0, Math.max(kind.configuredCount, kind.learnedCount))
        .map((device) => device.id),
    ),
  );
  for (const device of input.devices) {
    if (
      device.state === "ready" &&
      isIdle(device) &&
      input.waiting.some((demand) => !demand.inFlight && serves(device, demand))
    ) {
      kept.add(device.id);
    }
  }
  return kept;
}

/**
 * why: shutdowns for the ready, unleased devices that never served a lease and that no target or learned kind keeps,
 * once they have been ready longer than `idle.shutdownAfterMs`. The cleanup reaper times an idle
 * device from the end of its last lease, so it never sees one of these; this is the one rule that
 * does. A device a waiting request is about to be granted is spared, as in the budget's choice.
 */
function neverLeasedIdle(
  view: WarmPolicyView,
  running: readonly VirtualDevice[],
  proposed: readonly DeviceProposal[],
  room: Slots,
): DeviceProposal[] {
  const kept = targetedDevices({
    ...view,
    targets: [...view.targets, ...view.spared],
  });
  const already = new Set(proposed.map((proposal) => proposal.deviceId));
  const proposals: DeviceProposal[] = [];
  for (const device of running) {
    if (
      device.lastLeaseEndedAt !== undefined ||
      kept.has(device.id) ||
      already.has(device.id) ||
      view.now - readySince(device) <= view.config.shutdownAfterMs
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
  readonly bootable: readonly VirtualDevice[];
  readonly room: Slots;
  readonly held: Slots;
  readonly taken: Set<string>;
  readonly stuck: ReadonlySet<Platform>;
  readonly proposals: WarmProposal[];
  readonly kinds: readonly PlannedKind[];
  /** why: the idle ready devices a newer learned kind may shut down for a slot, least recently used first. */
  readonly victims: VirtualDevice[];
  readonly displaced: Set<string>;
  /** Pool boots and creations running or proposed, which `maxConcurrentBoots` bounds. */
  started: number;
}

/**
 * why: what each target still needs, and the boots and creations that fill it: a shut-down device
 * of its kind is booted before a new one is created, never while a waiter on its platform is one
 * the queue pass could not serve, never while its spec is held back after a failure, and never past the slots, the
 * device limit and RAM the capacity allows, nor past `maxConcurrentBoots` pool boots at once. A
 * target never shuts a device down: what it cannot fit it reports short.
 */
function planTargets(
  view: WarmPolicyView,
  targets: readonly PlannedKind[],
  bootable: readonly VirtualDevice[],
  queued: QueuePass,
  room: Slots,
  held: Slots,
  isIdleDevice: (device: VirtualDevice) => boolean,
  victims: readonly VirtualDevice[],
): { proposals: WarmProposal[]; reports: TargetReport[] } {
  const keepBoots = queued.proposals.flatMap((proposal) =>
    proposal.action === "boot" ? [proposal.deviceId] : [],
  );
  const displaced = new Set<string>();
  const isIdle = (device: VirtualDevice): boolean =>
    isIdleDevice(device) && !displaced.has(device.id);
  const plan: TargetPlan = {
    bootable,
    displaced,
    held,
    kinds: targets,
    proposals: [],
    room,
    started: queued.started,
    stuck: queued.stuck,
    taken: new Set(keepBoots),
    victims: [...victims],
    view,
  };
  const pending = (spec: VirtualSpec): number =>
    view.inFlight.filter((flying) => sameSpec(flying, spec)).length +
    queued.proposals.filter((proposal) =>
      proposal.action === "provision"
        ? sameSpec(proposal.spec, spec)
        : proposal.action === "boot" &&
          view.devices.some(
            (device) => device.id === proposal.deviceId && sameSpec(device.spec, spec),
          ),
    ).length;
  const reports = targets.map(({ configuredCount, learnedCount, origin, spec }): TargetReport => {
    const ready = readyOfKind(view.devices, isIdle, spec).length;
    const filling = pending(spec);
    const missing =
      Math.max(configuredCount - ready, learnedCount - haveOfKind(view, isIdle, spec)) - filling;
    const before = plan.proposals.length;
    const short = missing > 0 ? fillTarget(plan, spec, missing, filling > 0) : undefined;
    const report = {
      booting: filling + plan.proposals.length - before,
      configuredCount,
      count: Math.max(configuredCount, learnedCount),
      kind: kindOf(spec),
      origin,
      ready,
      spec,
      target: describeTarget(spec),
    };
    return short === undefined ? report : { ...report, short };
  });
  return { proposals: plan.proposals, reports };
}

/**
 * why: adds the boots and creations a target is missing, after the queue's. A target with a boot
 * already running or one proposed here is still filling, and one on a platform where a waiter
 * could not be served is waiting; neither is short, whatever stopped the rest.
 */
function fillTarget(
  plan: TargetPlan,
  spec: VirtualSpec,
  missing: number,
  filling: boolean,
): TargetShort | undefined {
  if (plan.stuck.has(spec.platform)) return undefined;
  if (!plan.view.retry.mayAttempt(spec, plan.view.now)) return filling ? undefined : "boot-failed";
  let added = 0;
  for (let left = missing; left > 0 && plan.started < plan.view.config.maxConcurrentBoots; left--) {
    const refused = addDisplacing(plan, spec);
    if (refused !== undefined) return added > 0 || filling ? undefined : refused;
    added += 1;
  }
  return undefined;
}

/**
 * why: a learned kind short for a running slot takes the least recently used idle ready device of
 * an older learned kind: the newest kinds are the ones asked for most lately. A configured target
 * and a kind short for anything but the slot never displace; configured targets come first in
 * `kinds`, so none is older than a learned kind and none is displaced.
 */
function displaceFor(plan: TargetPlan, spec: VirtualSpec): boolean {
  const index = plan.kinds.findIndex((entry) => sameSpec(entry.spec, spec));
  if (plan.kinds[index]?.origin !== "learned") return false;
  const victim = plan.victims.find((device) => {
    const entry = plan.kinds.findIndex((candidate) => sameSpec(candidate.spec, device.spec));
    return entry > index && device.spec.platform === spec.platform;
  });
  if (victim === undefined) return false;
  // why: a slot is not all the kind lacks; when the capacity strategy still refuses it with the victim down, the shutdown would free nothing the kind can use and the victim would boot back next pass.
  if (admitted(plan, spec, new Set([...plan.displaced, victim.id])) !== undefined) return false;
  plan.victims.splice(plan.victims.indexOf(victim), 1);
  plan.displaced.add(victim.id);
  release(plan.room, victim);
  plan.proposals.push({ action: "shutdown", deviceId: victim.id, reason: "displaced" });
  return true;
}

/** why: a learned kind refused for a running slot tries again after each displacement it can make. */
function addDisplacing(plan: TargetPlan, spec: VirtualSpec): TargetShort | undefined {
  let refused = addOne(plan, spec);
  while (refused === "running-limit" && displaceFor(plan, spec)) refused = addOne(plan, spec);
  return refused;
}

/** why: the shut-down device a boot of `spec` would use, which decides whether the capacity strategy is asked about a boot or a creation. */
function bootCandidate(plan: TargetPlan, spec: VirtualSpec): VirtualDevice | undefined {
  return plan.bootable.find(
    (device) =>
      !plan.taken.has(device.id) &&
      !plan.view.resetDevices.has(device.id) &&
      sameSpec(device.spec, spec),
  );
}

/** why: what the capacity strategy refuses for a boot or creation of `spec` once the `down` devices are shut down. */
function admitted(
  plan: TargetPlan,
  spec: VirtualSpec,
  down: ReadonlySet<string>,
): TargetShort | undefined {
  const shutDown = bootCandidate(plan, spec);
  return shortOf(
    shutDown === undefined
      ? plan.view.admit.create(spec, down)
      : plan.view.admit.boot(shutDown, down),
  );
}

/** why: proposes one boot of a shut-down device of the kind, else one creation, or says why it cannot. */
function addOne(plan: TargetPlan, spec: VirtualSpec): TargetShort | undefined {
  const shutDown = bootCandidate(plan, spec);
  // why: the order a user reads: device limit, running limit, reserve, then RAM budget.
  const capacity = admitted(plan, spec, plan.displaced);
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

/** A spec's kind as a report names it. */
function kindOf(spec: VirtualSpec): TargetKind {
  return {
    mode: specMode(spec),
    model: spec.model,
    platform: spec.platform,
    osVersion: spec.osVersion,
  };
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
